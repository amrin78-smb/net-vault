//
// lib/serviceRestart.ts — restarting the hub from Settings.
//
// Several settings are durable the moment they are saved and INERT until the
// service restarts: NEXTAUTH_URL (NextAuth builds its options once at startup),
// the ENTRA_* values, and a replaced certificate. Until now the panel's honest
// answer was "restart the NetVault service", which is only actionable by
// someone with a console on the server — so a customer's own settings page
// could save a change it could not apply.
//
// ⛔ THE RESTART CANNOT BE AWAITED BY THE REQUEST THAT ASKS FOR IT. The service
// being restarted is the one serving the request; `sc.exe stop NetVault` kills
// the process mid-response. It is handed to a scheduled task running as SYSTEM
// — the same shape as `lib/tlsTransport.ts` and the in-app updater, for the
// same reason — and the panel watches for the console coming back.
//
// ⛔ THE SERVICE NAME IS A CONSTANT HERE, NEVER A REQUEST FIELD. A route that
// restarts whatever service a JSON body names is a denial-of-service primitive
// handed to anyone who reaches it.
//
// ⛔ AND THAT RULE SURVIVED THE HUB LEARNING TO WRITE ALL FOUR CONSOLES'
// ADDRESSES. A console-address change can now need `LogVault-App`,
// `DDIVault-App`, `SpanVault-App` and `SpanVault-API` restarted as well — so the
// request carries a CLOSED ENUM OF APP SLUGS (`lib/consoles.ts`,
// `asConsoleSlug`) and the slug→service mapping stays here, in code. A slug is
// one of four constants; a service name would be anything the caller typed.

import { psLiteral } from './tlsTransport.ts'
import { psArmGuard, psLockHeartbeat, psLockTakeover } from './runLock.ts'
import { CONSOLES, HUB_SLUG, consoleRestartServices, type ConsoleSlug } from './consoles.ts'

/**
 * What the operator is trying to apply. ⛔ A PURPOSE, NEVER A SERVICE NAME FROM
 * A REQUEST: a route that restarts whatever service a JSON body names is a
 * denial-of-service primitive handed to anyone who reaches it.
 */
export type RestartPurpose = 'console-address' | 'certificate' | 'sso'

export const RESTART_PURPOSES: readonly RestartPurpose[] = ['console-address', 'certificate', 'sso']

export function isRestartPurpose(v: unknown): v is RestartPurpose {
  return typeof v === 'string' && (RESTART_PURPOSES as readonly string[]).includes(v)
}

/** The hub. Reads NEXTAUTH_URL and the ENTRA_* values once, at startup. */
export const HUB_SERVICE = CONSOLES[HUB_SLUG].service
/** The TLS front door. ⛔ THIS is the process that holds the certificate. */
export const TERMINATOR_SERVICE = 'NocVault-Tls'

/**
 * ⛔ A LIST, NOT A SERVICE, SINCE THE HUB OWNS FOUR CONSOLE ADDRESSES. It used
 * to be `{ service: string | null }` and `null` meant "there is nothing to
 * restart" — the certificate-with-no-terminator case. An empty list says the
 * same thing without a second shape for "none", and the callers that only ever
 * wanted one service read `services[0]` from a list of one.
 */
export type RestartTarget = { services: string[]; why: string }

/**
 * Which services have to restart for this change to take effect.
 *
 * ⛔ A CERTIFICATE IS NOT RESTARTED BY RESTARTING THE APP. NetVault's
 * standalone server never terminates TLS on this product — `NocVault-Tls`
 * does, and it reads the certificate at ITS startup. The Certificate panel
 * said "Restart the NetVault service to begin serving it", which is text from
 * before the terminator existed: following it restarts the wrong process, the
 * old certificate keeps being served, and the obvious conclusion is that the
 * install silently failed.
 *
 * CAUGHT when a real wildcard certificate was installed on production on
 * 2026-11-06 and the panel pointed at NetVault.
 *
 * ⛔ AND WITH NO TERMINATOR THERE IS NOTHING TO RESTART AT ALL. A certificate
 * on a suite serving plain HTTP changes nothing until HTTPS is turned on;
 * saying "restart X" there sends an operator to bounce a service for no
 * effect and conclude the certificate is broken.
 */
export function resolveRestartTarget(
  purpose: RestartPurpose,
  terminatorPresent: boolean,
  /**
   * Which consoles changed, for `console-address`.
   *
   * ⛔ IT DEFAULTS TO THE HUB, WHICH IS THE ANSWER THIS FUNCTION ALWAYS GAVE.
   * The GET handler has no way to know which apps a pending change covers, so
   * it asks with the default and gets today's behaviour; the POST is told, from
   * a closed enum, and gets the full list.
   */
  apps: readonly ConsoleSlug[] = [HUB_SLUG],
): RestartTarget {
  if (purpose === 'certificate') {
    if (!terminatorPresent) {
      return {
        services: [],
        why:
          'HTTPS is not turned on, so nothing is serving this certificate yet and there is nothing to '
          + 'restart. Turn HTTPS on from Settings → HTTPS and the new certificate is used from the start.',
      }
    }
    return {
      services: [TERMINATOR_SERVICE],
      why:
        `${TERMINATOR_SERVICE} is the process that terminates TLS and it reads the certificate when it `
        + 'starts. Restarting it serves the new certificate; the four consoles behind it are not restarted.',
    }
  }
  if (purpose === 'sso') {
    // ⛔ THE DIRECTORY SETTINGS ARE THE HUB'S ALONE. The satellites have no
    // Entra configuration — they verify a token the hub signed — so fanning an
    // SSO change out to them would bounce three consoles for no change at all.
    return {
      services: [HUB_SERVICE],
      why:
        'The directory settings are read once at startup, so single sign-on keeps using the old '
        + `values until ${HUB_SERVICE} restarts.`,
    }
  }
  // ⛔ DEDUPED, AND THE COMPANION SERVICES COME WITH THEIR CONSOLE.
  // `SpanVault-API` reads the same `NEXTAUTH_URL` out of the same file (its
  // dotenv loads the root `.env.local`) and puts it into the SSRF allow-list
  // that decides which hostnames a server-side fetch may use
  // (`spanvault/api/rbacScope.js`). Restart only `SpanVault-App` and the API
  // goes on trusting the old hostname and refusing the new one.
  const services = [...new Set(apps.flatMap((slug) => consoleRestartServices(slug)))]
  const labels = [...new Set(apps.map((slug) => CONSOLES[slug].label))]
  return {
    services,
    why:
      services.length <= 1
        ? 'NextAuth builds its options once at startup, so sign-in keeps using the old address '
          + `until ${services[0] || HUB_SERVICE} restarts.`
        : `NextAuth builds its options once at startup, so ${labels.join(', ')} keep using their old `
          + `addresses until these restart: ${services.join(', ')}.`,
  }
}

// ⛔ `RESTART_SERVICE` WAS REMOVED (1.63.0). It was an alias of `HUB_SERVICE`
// "kept for callers that only ever meant the hub", and it had none — so it was
// an inviting second name for the one fact this module is careful about
// (`resolveRestartTarget` exists precisely because the service is NOT always
// the hub). A future caller reaching for it would be reaching past that.

/** Deleted by the wrapper at the end of a run, so it is normally absent. */
export const RESTART_TASK_NAME = 'NocVault-ServiceRestart'

export const RESTART_SENTINEL = '[NV-RESTART] finished'

export type RestartPaths = { log: string; lock: string; wrapper: string }

export function restartPaths(repoRoot: string): RestartPaths {
  const sep = repoRoot.includes('/') && !repoRoot.includes('\\') ? '/' : '\\'
  const join = (...parts: string[]) => parts.join(sep)
  return {
    log: join(repoRoot, 'logs', 'service-restart.log'),
    lock: join(repoRoot, 'logs', 'service-restart.lock'),
    wrapper: join(repoRoot, 'logs', 'service-restart-run.ps1'),
  }
}

/**
 * The wrapper the scheduled task runs.
 *
 * ⛔ IT POLLS FOR `STOPPED` RATHER THAN SLEEPING. MEASURED on production:
 * LogVault-App reaches STOPPED in 517 ms but does not report RUNNING for
 * ~20 s (NSSM's start throttle), so neither a fixed sleep nor a RUNNING check
 * describes "is it back". `sc.exe start` issued while a service is still
 * STOP_PENDING is REJECTED, and the old code in the cutover ignored that
 * return — the same defect this file must not repeat.
 *
 * ⛔ AND IT KEEPS TRYING TO START THE SERVICE UNTIL IT IS RUNNING, WHICH IS
 * NOT THE SAME AS "even if the stop timed out" — the wording this header
 * carried, and which the loop below has never matched. A start issued while the
 * service is still `StopPending` is REJECTED by the SCM (1056/1061), so firing
 * one at that moment is guaranteed to fail; the loop deliberately SKIPS a
 * pending transition and asks again a second later, for up to 150 s. The
 * guarantee is therefore about the END STATE, not about one unconditional
 * attempt: the only way this returns without having started the service is the
 * service never leaving a pending state for 150 s. That still rules out the one
 * thing worse than a slow restart — a stop with no start after it, i.e. the hub
 * left down by a settings page.
 */
export function buildRestartWrapper(opts: {
  /**
   * The services to restart, in order.
   *
   * ⛔ A LIST, AND THE WRAPPER — NOT THE ROUTE — IS WHAT WALKS IT. The run lock
   * is a SINGLE file (`restartPaths` → one `logs/service-restart.lock`), so two
   * concurrent restarts are impossible by construction; firing one POST per
   * console would mean the second, third and fourth being refused with 409. One
   * wrapper taking the list also means the shared TLS front door is stopped
   * ONCE for the whole set and started again LAST, instead of being bounced
   * once per console.
   */
  services: string[]
  log: string
  lock: string
  taskName: string
  /**
   * Services that DEPEND ON the services above and must be stopped before
   * them, then started again after.
   *
   * ⛔ WITHOUT THIS THE RESTART IS A NO-OP THAT REPORTS SUCCESS.
   * `NocVault-Tls` declares `DependOnService NetVault`, so Windows REFUSES
   * `sc stop NetVault` with 1051 (ERROR_DEPENDENT_SERVICES_RUNNING) while the
   * terminator is running. The stop fails, the following `sc start` returns
   * 1056 (already running), the service is still Running — and a verdict based
   * on "is it running" reads all of that as a successful restart while the old
   * process, with the old NEXTAUTH_URL, never went anywhere.
   */
  dependents?: string[]
  /**
   * The run the ROUTE armed this wrapper for.
   *
   * ⛔ WITHOUT IT THE ORPHANED TASK RE-RUNS THIS UNATTENDED. See `psArmGuard`
   * in lib/runLock.ts: nothing deleted `NocVault-ServiceRestart` when the
   * wrapper STARTED and then died (reboot, task terminated, PowerShell crash),
   * and a `/sc once /st 00:00` trigger whose start time has passed fires the
   * following day — so a restart nobody asked for happened at midnight.
   */
  runId: string
}): string {
  const services = opts.services.filter((s) => s)
  const servicesLiteral = services.length ? `@(${services.map(psLiteral).join(', ')})` : '@()'
  // ⛔ A SERVICE IS NEVER ITS OWN DEPENDENT, and with a list that filter has to
  // consider EVERY service in the run: stopping SpanVault-App "as a dependent"
  // of SpanVault-API and then stopping it again as a target would double the
  // outage and confuse the verdict.
  const deps = (opts.dependents || []).filter((d) => d && !services.includes(d))
  const depsLiteral = deps.length ? `@(${deps.map(psLiteral).join(', ')})` : '@()'
  return [
    '# Generated by app/api/system/service-restart. Overwritten on every run.',
    "$ErrorActionPreference = 'Continue'",
    `$log  = ${psLiteral(opts.log)}`,
    `$lock = ${psLiteral(opts.lock)}`,
    `$services = ${servicesLiteral}`,
    'New-Item -ItemType Directory -Force -Path (Split-Path -Parent $log) | Out-Null',
    // ⛔ BEFORE ANY `sc.exe` CALL. An un-armed wrapper must stop a service.
    ...psArmGuard({ runId: opts.runId, taskName: opts.taskName, quote: psLiteral }),
    // ⛔ THE TAKEOVER, NOT THE CLAIM. The ROUTE claims the lock atomically
    // before the task exists (lib/runLock.ts, defect 1); this overwrites that
    // pending claim with the wrapper's own PID, which is the handover signal.
    psLockTakeover(),
    // ⛔ APPEND, NOT -Force. The ROUTE truncates this log and writes the
    // `runId=` header before scheduling the task, so the panel can tell ITS
    // run's verdict from the previous run's. If the wrapper truncated here,
    // there would be a window — task scheduled, wrapper not yet started — in
    // which the log still holds the PREVIOUS run's verdict, and the panel
    // would present it as this run's result.
    '"[NV-RESTART] services=$($services -join \', \') started $(Get-Date -Format s)" | Out-File -FilePath $log -Append -Encoding UTF8',
    `$deps = ${depsLiteral}`,
    '$rc = 1',
    '$allOk = $true',
    'try {',
    // ⛔ THE DEPENDENTS COME DOWN ONCE, FOR THE WHOLE SET. Stopping the shared
    // front door per console would take the public ports down N times.
    '    foreach ($d in $deps) {',
    '        $ds = (Get-Service -Name $d -ErrorAction SilentlyContinue)',
    '        if ($ds -and $ds.Status -ne \'Stopped\') {',
    '            $o = (& sc.exe stop $d 2>&1 | Out-String).Trim()',
    '            "[NV-RESTART] dependent $d stop: $($o -replace \'\\s+\', \' \')" | Out-File -FilePath $log -Append -Encoding UTF8',
    '            $dw = [Diagnostics.Stopwatch]::StartNew()',
    '            while ($dw.Elapsed.TotalSeconds -lt 45 -and (Get-Service -Name $d -ErrorAction SilentlyContinue).Status -ne \'Stopped\') { Start-Sleep -Milliseconds 250 }',
    '        }',
    '    }',
    '    foreach ($svc in $services) {',
    // ⛔ THE PID, NOT "IS IT RUNNING". A service that never stopped is still
    // Running, and that is exactly what a refused stop leaves behind. The only
    // evidence a restart happened is a DIFFERENT process.
    '        $before = (Get-CimInstance Win32_Service -Filter "Name=\'$svc\'" -ErrorAction SilentlyContinue).ProcessId',
    '        "[NV-RESTART] service=$svc pid before: $before" | Out-File -FilePath $log -Append -Encoding UTF8',
    '        $stopOut = (& sc.exe stop $svc 2>&1 | Out-String).Trim()',
    '        "[NV-RESTART] service=$svc stop issued: $($stopOut -replace \'\\s+\', \' \')" | Out-File -FilePath $log -Append -Encoding UTF8',
    '        $sw = [Diagnostics.Stopwatch]::StartNew()',
    '        while ($sw.Elapsed.TotalSeconds -lt 60) {',
    '            if ((Get-Service -Name $svc -ErrorAction SilentlyContinue).Status -eq \'Stopped\') { break }',
    `            ${psLockHeartbeat()}`,
    '            Start-Sleep -Milliseconds 250',
    '        }',
    '        $state = (Get-Service -Name $svc -ErrorAction SilentlyContinue).Status',
    '        "[NV-RESTART] service=$svc state after $([int]$sw.ElapsedMilliseconds) ms: $state" | Out-File -FilePath $log -Append -Encoding UTF8',
    // ⛔ UNCONDITIONAL **AND RETRIED**, and the retry is the load-bearing half.
    // The stop poll above exits either because the service reached Stopped or
    // because it timed out — and the only way it times out is the service
    // still being STOP_PENDING, which is precisely the state in which
    // `sc start` is rejected (1056/1061). A single start issued at that
    // moment is guaranteed to be refused, and the old code then only
    // OBSERVED Status for 120 s without ever asking again: the service
    // finished stopping a few seconds later and stayed Stopped forever.
    // That is the console left down by a settings page — the one outcome
    // this function's header calls worse than a slow restart.
    '        $running = $false',
    '        $sw2 = [Diagnostics.Stopwatch]::StartNew()',
    '        $attempt = 0',
    '        while ($sw2.Elapsed.TotalSeconds -lt 150) {',
    '            $st = (Get-Service -Name $svc -ErrorAction SilentlyContinue).Status',
    '            if ($st -eq \'Running\') { $running = $true; break }',
    // ⛔ AN ABSENT SERVICE IS NOT A PENDING ONE. `$st` is `$null` when
    // `Get-Service` finds nothing, and `$null` passes both `-ne` tests below —
    // so this loop used to issue `sc.exe start` ONCE A SECOND FOR 150 SECONDS
    // against a name the SCM does not have, writing 150 log lines and hammering
    // the SCM for two and a half minutes before ending in a (correct) `failed`.
    // Reachable through the route's own tri-state: `present === null` means "we
    // could not ask", `present !== false` offers the target anyway, and
    // `serviceExists() === null` does not block it either — both deliberately,
    // so the honest place to notice is here. One line, and stop.
    '            if ($null -eq $st) {',
    '                "[NV-RESTART] service=$svc is not installed on this host - nothing to start." |',
    '                    Out-File -FilePath $log -Append -Encoding UTF8',
    '                break',
    '            }',
    // Never fire into a pending transition: that is the rejection above.
    '            if ($st -ne \'StartPending\' -and $st -ne \'StopPending\') {',
    '                $attempt = $attempt + 1',
    '                $startOut = (& sc.exe start $svc 2>&1 | Out-String).Trim()',
    '                "[NV-RESTART] service=$svc start attempt $attempt : $($startOut -replace \'\\s+\', \' \')" | Out-File -FilePath $log -Append -Encoding UTF8',
    '            }',
    // ⛔ THE HEARTBEAT. `LOCK_IDLE_MS` is a death signal only because this
    // runs; with one write at start, age alone reaped a live run's lock.
    `            ${psLockHeartbeat()}`,
    '            Start-Sleep -Milliseconds 1000',
    '        }',
    '        $after = (Get-CimInstance Win32_Service -Filter "Name=\'$svc\'" -ErrorAction SilentlyContinue).ProcessId',
    '        $changed = ($before -ne $after)',
    '        "[NV-RESTART] service=$svc pid after: $after changed=$changed" | Out-File -FilePath $log -Append -Encoding UTF8',
    '        "[NV-RESTART] service=$svc running=$running after $([int]$sw2.ElapsedMilliseconds) ms" | Out-File -FilePath $log -Append -Encoding UTF8',
    // ⛔ ONE FAILED SERVICE FAILS THE RUN. The panel reads the verdict, and
    // "three of four consoles took the new address" must not read as success —
    // the fourth is the one nobody can sign in to.
    '        if (-not ($running -and $changed)) { $allOk = $false }',
    '    }',
    // The dependents go back up LAST, and whether they do is part of the
    // verdict: a terminator left stopped means four consoles unreachable.
    '    $depsBack = $true',
    '    foreach ($d in $deps) {',
    '        $null = & sc.exe start $d 2>&1',
    '        $dw2 = [Diagnostics.Stopwatch]::StartNew()',
    '        $ok = $false',
    '        while ($dw2.Elapsed.TotalSeconds -lt 90) {',
    '            if ((Get-Service -Name $d -ErrorAction SilentlyContinue).Status -eq \'Running\') { $ok = $true; break }',
    `            ${psLockHeartbeat()}`,
    '            Start-Sleep -Milliseconds 500',
    '        }',
    '        if (-not $ok) { $depsBack = $false }',
    '        "[NV-RESTART] dependent $d back: $ok" | Out-File -FilePath $log -Append -Encoding UTF8',
    '    }',
    '    $rc = if ($allOk -and $depsBack) { 0 } else { 1 }',
    '} catch {',
    '    "[NV-RESTART] wrapper error: $($_.Exception.Message)" | Out-File -FilePath $log -Append -Encoding UTF8',
    '    $rc = 1',
    '} finally {',
    `    "${RESTART_SENTINEL} exit=$rc" | Out-File -FilePath $log -Append -Encoding UTF8`,
    '    Remove-Item -LiteralPath $lock -Force -ErrorAction SilentlyContinue',
    `    & schtasks.exe /delete /tn ${psLiteral(opts.taskName)} /f 2>&1 | Out-Null`,
    '}',
    '',
  ].join('\r\n')
}

/**
 * How long a panel should wait for a verdict before admitting it cannot confirm.
 *
 * ⛔ IT SCALES WITH THE RUN, BECAUSE A FIXED LIMIT IS WRONG AS SOON AS THE LIST
 * CAN HOLD MORE THAN ONE SERVICE. The wrapper's own bounds add up, per service:
 * 60 s polling for Stopped plus 150 s of start attempts; plus, once for the run,
 * 45 s stopping each dependent and 90 s waiting for each to come back. Four
 * consoles (six services: SpanVault brings its API and LogVault its collector)
 * with the front door declared is 45 + 6×210 + 90 = 1395 s — so the old flat seven-minute limit
 * would have reported "could not confirm the restart" for a restart that was
 * working normally, on the very change this feature exists to make.
 */
export function restartWaitLimitMs(serviceCount: number, dependentCount = 0): number {
  const services = Math.max(1, Math.floor(serviceCount) || 1)
  const deps = Math.max(0, Math.floor(dependentCount) || 0)
  // A slack term, because the sentinel is written after the last log line and a
  // loaded host does everything slower than its own timeout bounds.
  return ((60 + 150) * services + (45 + 90) * deps + 60) * 1000
}

export type RestartOutcome = 'none' | 'running' | 'succeeded' | 'failed'

export type ServiceVerdict = {
  /** `''` for a log written before the per-service lines carried a name. */
  service: string
  /** ⛔ `null` means the line was never written — the run did not get that far. */
  running: boolean | null
  changed: boolean | null
}

export type RestartReport = {
  outcome: RestartOutcome
  finished: boolean
  lines: string[]
  /** Which run this log belongs to, so a panel never reads a stale verdict. */
  runId: string | null
  /** Per-service, so a panel can name the console that did not come back. */
  services: ServiceVerdict[]
  /** The ones that failed, named. Empty when the run succeeded. */
  failedServices: string[]
}

/** The header the ROUTE writes before scheduling, stamping this run's id. */
export const RESTART_RUN_PREFIX = '[NV-RESTART] runId='

export function buildRestartHeader(runId: string, services: string[]): string {
  return `${RESTART_RUN_PREFIX}${runId} services=${services.join(',')}\r\n`
}

/**
 * What the last restart did.
 *
 * ⛔ THIS DOC BELONGS TO `parseRestartLog` AND SAT ABOVE A STRING CONSTANT.
 * `RESTART_RUN_PREFIX`/`buildRestartHeader` were inserted BETWEEN the comment
 * and the function it describes, so "What the last restart did" documented a
 * prefix literal and the function that reads the verdict had none. Moved, not
 * rewritten.
 *
 * ⛔ `running=True` IS THE VERDICT, NOT THE EXIT CODE — same rule as
 * `lib/tlsTransport.ts`, and for the same reason: on this codebase a
 * PowerShell exit code is evidence of nothing. The wrapper writes whether the
 * service actually came back, and that line is what is read.
 */
export function parseRestartLog(text: string | null | undefined): RestartReport {
  const none: RestartReport = {
    outcome: 'none', finished: false, lines: [], runId: null, services: [], failedServices: [],
  }
  if (text === null || text === undefined) return none
  const lines = String(text).split(/\r?\n/).map((l) => l.replace(/\s+$/, '')).filter((l) => l !== '')
  const finished = lines.some((l) => l.startsWith(RESTART_SENTINEL))
  const idLine = lines.find((l) => l.startsWith(RESTART_RUN_PREFIX))
  const runId = idLine ? (idLine.slice(RESTART_RUN_PREFIX.length).split(/\s+/)[0] || null) : null

  // ⛔ PER SERVICE, AND THE `service=` PREFIX IS OPTIONAL ON PURPOSE. A restart
  // can now cover up to six services, so one `running=True` anywhere in the
  // file is not a verdict about the run — but the log on disk immediately after
  // a deploy may still be the PREVIOUS build's, written without the prefix. An
  // unprefixed line is therefore read as one unnamed service rather than
  // ignored, which would turn an old failed run into `succeeded` (no lines
  // found, nothing to disagree with).
  const seen = new Map<string, ServiceVerdict>()
  const at = (service: string): ServiceVerdict => {
    const existing = seen.get(service)
    if (existing) return existing
    const fresh: ServiceVerdict = { service, running: null, changed: null }
    seen.set(service, fresh)
    return fresh
  }
  for (const line of lines) {
    const run = /\[NV-RESTART\] (?:service=(\S+) )?running=(True|False)/i.exec(line)
    if (run) at(run[1] || '').running = /^true$/i.test(run[2])
    const pid = /\[NV-RESTART\] (?:service=(\S+) )?pid after: \S* ?changed=(True|False)/i.exec(line)
    if (pid) at(pid[1] || '').changed = /^true$/i.test(pid[2])
  }
  const services = [...seen.values()]
  if (!finished) {
    return { outcome: 'running', finished: false, lines, runId, services, failedServices: [] }
  }
  // ⛔ BOTH, AND `changed` IS THE LOAD-BEARING HALF. A refused stop (1051,
  // dependent service running) leaves the service Running the whole time, so
  // `running=True` alone is exactly what a restart that never happened looks
  // like. A different PID is the only proof the process was replaced.
  //
  // ⛔ AND IT IS EVERY SERVICE, NOT ANY. "Three of the four consoles took the
  // new address" is not a success: the fourth is the one nobody can sign in to.
  const failedServices = services
    .filter((s) => !(s.running === true && s.changed === true))
    .map((s) => s.service)
  const ran = services.length > 0
  const changed = failedServices.length === 0
  // ⛔ AND THE DEPENDENTS HAVE TO BE BACK. The wrapper already makes `$depsBack`
  // a third term of its exit code — and this function deliberately ignores exit
  // codes, so that term was being written into a value nothing read. The log
  // line is right there. Without this, "the hub restarted cleanly but
  // NocVault-Tls never came back" reported `succeeded` while all four consoles'
  // public ports were dead — a false all-clear from the one function whose
  // entire job is to refuse them.
  const depsFailed = lines.some((l) => /\[NV-RESTART\] dependent .* back: False/i.test(l))
  return {
    outcome: ran && changed && !depsFailed ? 'succeeded' : 'failed',
    finished: true,
    lines,
    runId,
    services,
    failedServices,
  }
}
